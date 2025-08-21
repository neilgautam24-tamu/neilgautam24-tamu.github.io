// Navbar functionality
const navbar = document.getElementById('navbar');
const navMenu = document.getElementById('nav-menu');
const hamburger = document.getElementById('hamburger');
const navLinks = document.querySelectorAll('.nav-link');

// Navbar scroll effect
window.addEventListener('scroll', () => {
    if (window.scrollY > 100) {
        navbar.classList.add('scrolled');
    } else {
        navbar.classList.remove('scrolled');
    }
});

// Mobile menu toggle
if (hamburger) {
    hamburger.addEventListener('click', () => {
        navMenu.classList.toggle('active');
    });
}

// Close mobile menu when clicking on a link
navLinks.forEach(link => {
    link.addEventListener('click', () => {
        navMenu.classList.remove('active');
    });
});

// Smooth scrolling for navigation links
navLinks.forEach(link => {
    link.addEventListener('click', (e) => {
        e.preventDefault();
        const targetId = link.getAttribute('href').substring(1);
        const targetSection = document.getElementById(targetId);
        
        if (targetSection) {
            const navbarHeight = navbar.offsetHeight;
            const targetPosition = targetSection.getBoundingClientRect().top + window.pageYOffset - navbarHeight;
            
            window.scrollTo({
                top: targetPosition,
                behavior: 'smooth'
            });
        }
    });
});

// Active navigation highlighting
function updateActiveNavigation() {
    const sections = document.querySelectorAll('section[id]');
    const navbarHeight = navbar.offsetHeight;
    
    sections.forEach(section => {
        const sectionTop = section.getBoundingClientRect().top;
        const sectionHeight = section.offsetHeight;
        const sectionId = section.getAttribute('id');
        const correspondingNavLink = document.querySelector(`.nav-link[href="#${sectionId}"]`);
        
        if (sectionTop <= navbarHeight + 100 && sectionTop + sectionHeight > navbarHeight + 100) {
            navLinks.forEach(link => link.classList.remove('active'));
            if (correspondingNavLink) {
                correspondingNavLink.classList.add('active');
            }
        }
    });
}

window.addEventListener('scroll', updateActiveNavigation);

// Skill bars animation
function animateSkillBars() {
    const skillBars = document.querySelectorAll('.skill-progress');
    
    const observerOptions = {
        threshold: 0.7,
        rootMargin: '0px 0px -100px 0px'
    };
    
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const skillBar = entry.target;
                const targetWidth = skillBar.dataset.width;
                if (targetWidth) {
                    skillBar.style.width = targetWidth + '%';
                }
            }
        });
    }, observerOptions);
    
    skillBars.forEach(bar => observer.observe(bar));
}

// Initialize skill bars animation
animateSkillBars();

// Simple fade-in animation for sections
function initScrollAnimations() {
    const sections = document.querySelectorAll('section');
    
    const observerOptions = {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    };
    
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.style.opacity = '1';
                entry.target.style.transform = 'translateY(0)';
            }
        });
    }, observerOptions);
    
    sections.forEach(section => {
        section.style.opacity = '0';
        section.style.transform = 'translateY(20px)';
        section.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
        observer.observe(section);
    });
}

// Initialize animations
initScrollAnimations();

// Loading animation
window.addEventListener('load', () => {
    document.body.style.opacity = '1';
    document.body.style.transition = 'opacity 0.3s ease';
});

// Set initial body opacity
document.body.style.opacity = '0';

console.log('Portfolio loaded successfully!');
